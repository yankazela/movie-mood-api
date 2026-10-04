import { ApiResponse, ResponseService } from "@novha/cdk-lib";

export const get = async (): Promise<ApiResponse> => {
    const responseService = new ResponseService();
    try {
        
        return responseService.success({ success: true });

    } catch (error: any) {
        console.error("Error in application:", error.message);

        return responseService.failure({ errorMessage: error.message });
    }
};